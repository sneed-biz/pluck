const DEFAULT_ATTEMPTS = 4;
const DEFAULT_DELAY_MS = 25;

export async function retryArtifactRead<T>(read: () => Promise<T>, attempts = DEFAULT_ATTEMPTS): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await delay(DEFAULT_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
