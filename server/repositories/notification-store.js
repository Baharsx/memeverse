import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class MemoryNotificationStore {
  constructor(seed = []) {
    this.receipts = new Map(seed.map((receipt) => [receipt.notificationId, structuredClone(receipt)]));
    this.queue = Promise.resolve();
  }

  async initialize() {}

  async processOnce(notificationId, operation) {
    const result = this.queue.then(async () => {
      const existing = this.receipts.get(notificationId);
      if (existing) return { receipt: structuredClone(existing), replayed: true };
      const outcome = await operation();
      const receipt = { notificationId, processedAt: new Date().toISOString(), outcome };
      this.receipts.set(notificationId, structuredClone(receipt));
      return { receipt, replayed: false };
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class JsonNotificationStore extends MemoryNotificationStore {
  constructor(filePath) {
    super();
    this.filePath = filePath;
  }

  async initialize() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.notifications)) {
        throw new Error('Unsupported Circle notification data format.');
      }
      this.receipts = new Map(
        data.notifications.map((receipt) => [receipt.notificationId, receipt]),
      );
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
  }

  async processOnce(notificationId, operation) {
    const result = this.queue.then(async () => {
      const existing = this.receipts.get(notificationId);
      if (existing) return { receipt: structuredClone(existing), replayed: true };
      const outcome = await operation();
      const receipt = { notificationId, processedAt: new Date().toISOString(), outcome };
      this.receipts.set(notificationId, structuredClone(receipt));
      await this.persist();
      return { receipt, replayed: false };
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async persist() {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const payload = JSON.stringify(
      { version: 1, notifications: [...this.receipts.values()] },
      null,
      2,
    );
    await writeFile(temporaryPath, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }
}
