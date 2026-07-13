#!/usr/bin/env node
"use strict";
const fs = require("fs"), vm = require("vm"), path = require("path");
const srcFile = process.argv[2];
if(!srcFile){ console.error("usage: node run_np.js <in.nim> [fileField]"); process.exit(2); }
globalThis.__np_src = fs.readFileSync(srcFile, "utf8");
globalThis.__np_file = process.argv[3] || path.basename(srcFile);
const bundle = fs.readFileSync(path.join(__dirname,"nifparser.js"),"utf8");
vm.runInThisContext(bundle + "\nmain(0, []);\n", { filename:"nifparser.js" });
process.stdout.write(globalThis.__np_out || "");
