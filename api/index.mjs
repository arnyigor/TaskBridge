// Vercel entry point at the repository root.
//
// The cloud API lives in cloud/api/index.mjs and the shared router/store/auth
// code is in cloud/lib/, but the router also imports the protocol helpers from
// src/domain/. Deploying with the repository root as the Vercel project root
// keeps those imports resolvable, so this file only re-exports the handler.
//
// Configure the project with the root vercel.json (outputDirectory: cloud/web).
export { default } from '../cloud/api/index.mjs';
