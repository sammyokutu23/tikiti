export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.JOBS_INLINE_WORKER === "false") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { startInlineWorker } = await import("./server/jobs/worker");
  startInlineWorker();
}
