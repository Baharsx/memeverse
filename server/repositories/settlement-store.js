import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DomainError } from '../domain/errors.js';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

export class MemorySettlementStore {
  constructor(seed = []) {
    this.records = new Map(seed.map((record) => [record.id, clone(record)]));
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

  async createIfAbsent(record) {
    const existing = [...this.records.values()].find(
      (candidate) => candidate.idempotencyKey === record.idempotencyKey,
    );
    if (existing) return { record: clone(existing), created: false };

    this.records.set(record.id, clone(record));
    return { record: clone(record), created: true };
  }

  async update(record) {
    if (!this.records.has(record.id)) {
      throw new DomainError('SETTLEMENT_NOT_FOUND', 'Settlement was not found.', { status: 404 });
    }
    this.records.set(record.id, clone(record));
    return clone(record);
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

  async createIfAbsent(record) {
    return this.mutate(async () => {
      const existing = [...this.records.values()].find(
        (candidate) => candidate.idempotencyKey === record.idempotencyKey,
      );
      if (existing) return { record: clone(existing), created: false };

      this.records.set(record.id, clone(record));
      await this.persist();
      return { record: clone(record), created: true };
    });
  }

  async update(record) {
    return this.mutate(async () => {
      if (!this.records.has(record.id)) {
        throw new DomainError('SETTLEMENT_NOT_FOUND', 'Settlement was not found.', { status: 404 });
      }
      this.records.set(record.id, clone(record));
      await this.persist();
      return clone(record);
    });
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
