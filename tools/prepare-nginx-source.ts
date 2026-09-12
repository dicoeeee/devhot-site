import { NGINX_TARBALL_SHA256, prepareNginxSource } from "./nginx-source.ts";

const output = process.argv[2];
if (output === undefined) throw new Error("deployment_nginx_source_destination_required");
await prepareNginxSource(output);
console.log(`Prepared pinned Nginx source: ${NGINX_TARBALL_SHA256}`);
