class NodeFileReaderPolyfill {
  public result: ArrayBuffer | null = null;
  public error: Error | null = null;
  public onload: ((ev: { target: NodeFileReaderPolyfill }) => void) | null = null;
  public onerror: ((err: unknown) => void) | null = null;

  readAsArrayBuffer(blob: Blob): void {
    void blob
      .arrayBuffer()
      .then((buffer) => {
        this.result = buffer;
        this.onload?.({ target: this });
      })
      .catch((err) => {
        this.error = err instanceof Error ? err : new Error(String(err));
        this.onerror?.(err);
      });
  }
}

if (typeof (globalThis as any).FileReader === "undefined") {
  (globalThis as any).FileReader = NodeFileReaderPolyfill;
}
