/**
 * Launch the reference registry server (see src/registry/server.ts).
 *
 *   npm run registry-server
 *
 * Env:
 *   AGI_REGISTRY_DIR    where recipe JSON files live   (default ./registry-data)
 *   AGI_REGISTRY_PORT   listen port                    (default 4318)
 *   AGI_REGISTRY_TOKEN  if set, POST /publish requires `Authorization: Bearer <token>`
 *
 * Then point the orchestrator's config at it:
 *   "registry": {
 *     "url": "http://localhost:4318/recipes",
 *     "publishUrl": "http://localhost:4318/publish",
 *     "token": "<same as AGI_REGISTRY_TOKEN, if set>"
 *   }
 */
import path from "node:path";
import { createRegistryServer } from "../src/registry/server.js";

const dir = path.resolve(process.env.AGI_REGISTRY_DIR ?? "registry-data");
const port = Number(process.env.AGI_REGISTRY_PORT ?? 4318);
const token = process.env.AGI_REGISTRY_TOKEN || undefined;

const server = createRegistryServer({ dir, token });
server.listen(port, () => {
  console.log(`reference registry server on http://localhost:${port}`);
  console.log(`  recipes dir : ${dir}`);
  console.log(`  GET  /recipes  → browse`);
  console.log(`  POST /publish  → publish${token ? " (Bearer token required)" : " (open — set AGI_REGISTRY_TOKEN to require auth)"}`);
});
