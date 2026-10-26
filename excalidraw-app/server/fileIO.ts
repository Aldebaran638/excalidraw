import fs from "node:fs/promises";

/** Retry reads only. Never turn a failed read into a new file or identity.
 * Mounted filesystems may briefly reject reads during atomic replacement. */
export async function readUtf8(file: string) {
  const retryable = new Set(["ENOENT", "ENODATA", "EIO", "EBUSY"]);
  let previousCode = "";
  for (let attempt = 0; ; attempt++) {
    try {
      const text = await fs.readFile(file, "utf8");
      if (attempt) {
        // Metadata only: do not log filenames, source or conversation content.
        // eslint-disable-next-line no-console
        console.warn(
          JSON.stringify({
            event: "repository_read_recovered",
            errorCode: previousCode,
            attempts: attempt + 1,
          }),
        );
      }
      return text;
    } catch (error) {
      previousCode = (error as NodeJS.ErrnoException).code || "unknown";
      if (!retryable.has(previousCode) || attempt >= 3) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 30 * 2 ** attempt));
    }
  }
}
