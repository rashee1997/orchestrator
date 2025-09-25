export async function executeWithRetry<T>(
  operation: () => T,
  options: { opName: string; maxRetries: number; retryDelay: number }
): Promise<T> {
  const { opName, maxRetries, retryDelay } = options;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await Promise.resolve(operation());
      return result;
    } catch (error: any) {
      lastError = error;
      console.warn(`${opName} failed (attempt ${attempt}/${maxRetries}):`, error?.message ?? error);
      if (attempt < maxRetries) {
        const delay = retryDelay * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  console.error(`${opName} failed after ${maxRetries} attempts:`, lastError?.message);
  throw lastError || new Error(`${opName} failed after maximum retries`);
}