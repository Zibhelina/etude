import { etudeFetch } from "./transport";
export async function autoSync() {
  try { await etudeFetch("/api/sync/auto",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"}); } catch {}
}
