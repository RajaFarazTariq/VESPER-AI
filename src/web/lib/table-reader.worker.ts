/**
 * Background worker that reads a spreadsheet (v0.14.0), so the page stays responsive with big files.
 * In: { file, preferMdy }. Out: { type: "progress", message } … then { type: "done", result } or { type: "error", message }.
 */
import { readTableFile } from "./table-file";
import { TableReadError } from "./table-read";

type Out = (message: unknown) => void;
const post: Out = (message) => (globalThis as unknown as { postMessage: Out }).postMessage(message);

addEventListener("message", (event: MessageEvent<{ file: File; preferMdy: boolean }>) => {
  const { file, preferMdy } = event.data;
  readTableFile(file, { preferMdy }, (message) => post({ type: "progress", message }))
    .then((result) => post({ type: "done", result }))
    .catch((error: unknown) =>
      post({ type: "error", message: error instanceof TableReadError ? error.message : "That spreadsheet couldn't be read." }),
    );
});
