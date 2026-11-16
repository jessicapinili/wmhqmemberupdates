// Runs every 5 minutes and sends anything that's due.
import { processDue } from "./api.mjs";
export default async () => { const r = await processDue(); console.log("scheduled run", r); };
export const config = { schedule: "*/5 * * * *" };
