import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DomainError } from '../domain/errors.js';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

const reservationTerminalStates = new Set(['COMPLETE', 'DENIED', 'EXPIRED', 'CANCELLED', 'FAILED']);

function withInitialReservation(
  record,
  records,
  treasuryAvailableUnits,
  agentDailyCapUnits,
) {
  if (!record.policy?.approved) return { ...record, reservation: null };
  const recordList = [...records];
  const requestedUnits = BigInt(record.amount.creatorPayoutUnits);
  const reservedUnits = recordList
    .filter((candidate) => ['ACTIVE', 'HELD'].includes(candidate.reservation?.status))
    .reduce((sum, candidate) => sum + BigInt(candidate.reservation.units), 0n);
  if (treasuryAvailableUnits !== undefined
    && reservedUnits + requestedUnits > BigInt(treasuryAvailableUnits)) {
    throw new DomainError(
      'TREASURY_CAPACITY_EXCEEDED',
      'Available Arc USDC is already reserved by active settlements.',
      {
        status: 409,
        details: {
          availableUnits: BigInt(treasuryAvailableUnits).toString(),
          reservedUnits: reservedUnits.toString(),
          requestedUnits: requestedUnits.toString(),
        },
      },
    );
  }
  const recordDay = record.createdAt.slice(0, 10);
  const agentDailyUsedUnits = recordList
    .filter((candidate) => candidate.agentDecision
      && candidate.createdAt.slice(0, 10) === recordDay
      && ['ACTIVE', 'HELD', 'CONSUMED'].includes(candidate.reservation?.status))
    .reduce((sum, candidate) => sum + BigInt(candidate.reservation.units), 0n);
  if (agentDailyCapUnits !== undefined
    && agentDailyUsedUnits + requestedUnits > BigInt(agentDailyCapUnits)) {
    throw new DomainError(
      'AGENT_DAILY_CAP_EXCEEDED',
      'The agent daily payout cap has been reached.',
      { status: 409 },
    );
  }
  return {
    ...record,
    reservation: {
      units: requestedUnits.toString(),
      status: 'ACTIVE',
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  };
}

/**
 * Mirrors the PostgreSQL optimistic-concurrency contract so domain code behaves identically
 * against embedded and managed storage.
 */
function nextVersionOrConflict(existing, record) {
  const expectedVersion = Number(record.version ?? 0);
  const currentVersion = Number(existing.version ?? 0);
  if (currentVersion !== expectedVersion) {
    throw new DomainError(
      'SETTLEMENT_VERSION_CONFLICT',
      'The settlement was modified by another writer.',
      { status: 409, details: { expectedVersion, currentVersion } },
    );
  }
  return expectedVersion + 1;
}

function withUpdatedReservation(record) {
  if (!record.reservation) return record;
  let status = record.reservation.status;
  if (record.state === 'COMPLETE') status = 'CONSUMED';
  else if (record.state === 'FAILED' && (record.broadcast || record.circle?.transactionId)) status = 'HELD';
  else if (reservationTerminalStates.has(record.state)) status = 'RELEASED';
  return {
    ...record,
    reservation: {
      ...record.reservation,
      status,
      updatedAt: record.updatedAt,
    },
  };
}

export class MemorySettlementStore {
  constructor(seed = []) {
    this.records = new Map(seed.map((record) => [record.id, clone(record)]));
    this.writeQueue = Promise.resolve();
  }

  async initialize() {}

  async list() {
    return [...this.records.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async get(id) {
    return clone(this.records.get(id));
  }

  async getByIdempotencyKey(key) {
    return clone([...this.records.values()].find((record) => record.idempotencyKey === key));
  }

  async getByCircleTransactionId(id) {
    return clone([...this.records.values()].find((record) => record.circle?.transactionId === id));
  }

  async createIfAbsent(record, { treasuryAvailableUnits, agentDailyCapUnits } = {}) {
    return this.mutate(async () => {
      const existing = [...this.records.values()].find(
        (candidate) => candidate.idempotencyKey === record.idempotencyKey,
      );
      if (existing) return { record: clone(existing), created: false };

      const stored = withInitialReservation(
        record,
        this.records.values(),
        treasuryAvailableUnits,
        agentDailyCapUnits,
      );
      const versioned = { ...stored, version: 0 };
      this.records.set(versioned.id, clone(versioned));
      return { record: clone(versioned), created: true };
    });
  }

  async update(record) {
    const existing = this.records.get(record.id);
    if (!existing) {
      throw new DomainError('SETTLEMENT_NOT_FOUND', 'Settlement was not found.', { status: 404 });
    }
    const version = nextVersionOrConflict(existing, record);
    const stored = { ...withUpdatedReservation(record), version };
    this.records.set(stored.id, clone(stored));
    return clone(stored);
  }

  async listReconciliationCandidates() {
    return [...this.records.values()]
      .filter((record) => record.circle?.transactionId && !['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'].includes(record.state))
      .map(clone);
  }

  async claimReconciliationCandidates() {
    return this.listReconciliationCandidates();
  }

  async releaseReconciliationLease() {}

  mutate(operation) {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class JsonSettlementStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.records = new Map();
    this.writeQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.settlements)) {
        throw new Error('Unsupported settlement data format.');
      }
      this.records = new Map(data.settlements.map((record) => [record.id, record]));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
  }

  async list() {
    await this.writeQueue;
    return [...this.records.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async get(id) {
    await this.writeQueue;
    return clone(this.records.get(id));
  }

  async getByIdempotencyKey(key) {
    await this.writeQueue;
    return clone([...this.records.values()].find((record) => record.idempotencyKey === key));
  }

  async getByCircleTransactionId(id) {
    await this.writeQueue;
    return clone([...this.records.values()].find((record) => record.circle?.transactionId === id));
  }

  async createIfAbsent(record, { treasuryAvailableUnits, agentDailyCapUnits } = {}) {
    return this.mutate(async () => {
      const existing = [...this.records.values()].find(
        (candidate) => candidate.idempotencyKey === record.idempotencyKey,
      );
      if (existing) return { record: clone(existing), created: false };

      const stored = withInitialReservation(
        record,
        this.records.values(),
        treasuryAvailableUnits,
        agentDailyCapUnits,
      );
      const versioned = { ...stored, version: 0 };
      this.records.set(versioned.id, clone(versioned));
      await this.persist();
      return { record: clone(versioned), created: true };
    });
  }

  async update(record) {
    return this.mutate(async () => {
      const existing = this.records.get(record.id);
      if (!existing) {
        throw new DomainError('SETTLEMENT_NOT_FOUND', 'Settlement was not found.', { status: 404 });
      }
      const version = nextVersionOrConflict(existing, record);
      const stored = { ...withUpdatedReservation(record), version };
      this.records.set(stored.id, clone(stored));
      await this.persist();
      return clone(stored);
    });
  }

  async listReconciliationCandidates() {
    await this.writeQueue;
    return [...this.records.values()]
      .filter((record) => record.circle?.transactionId && !['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED'].includes(record.state))
      .map(clone);
  }

  mutate(operation) {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      { version: 1, settlements: [...this.records.values()] },
      null,
      2,
    );
    await writeFile(temporaryPath, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
