import { Pool } from "pg";
import { config } from "./config.js";

export const pool = new Pool({ connectionString: config.pgUrl, max: 10 });

// node-pg hands back bigint as a string to avoid precision loss. seq fits in a
// JS number for any realistic conversation, and the client compares it
// numerically, so parse it at the boundary rather than leaking strings upward.
import pgTypes from "pg";
pgTypes.types.setTypeParser(20, (v: string) => Number(v));
