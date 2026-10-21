#!/usr/bin/env node
// etude: the command line. Everything the app can do, as JSON-speaking commands.
import { run } from "./run.ts";

const code = await run(process.argv.slice(2));
if (code !== 0) process.exitCode = code;
