// agent-provider-kit: T3's bin.ts fast paths that provider code spawns by file path.
// DocumentText runs `node bin.ts __document-text <path> <ext>` to extract attachment text.
if (process.argv[2] === "__document-text") {
  const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
  try {
    process.stdout.write(await extractDocumentText(process.argv[3]!, process.argv[4]!));
  } catch (error) {
    if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
      throw error;
    }
    // Exit 2 identifies document rejections; OS and process failures remain retryable.
    process.exitCode = 2;
  }
}
