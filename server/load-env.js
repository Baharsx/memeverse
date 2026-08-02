export function loadLocalEnvironment() {
  for (const path of ['.env.local', '.env']) {
    try {
      process.loadEnvFile?.(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
