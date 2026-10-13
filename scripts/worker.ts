/** Standalone outbox worker for production: `npm run worker`. */
import "dotenv/config";
import { workerTick } from "@/server/jobs/worker";

const interval = Number(process.env.WORKER_INTERVAL_MS ?? 3000);
console.log(`Tikiti worker running every ${interval}ms`);
const loop = async () => {
  await workerTick();
  setTimeout(loop, interval);
};
loop();
