# Standalone container for the outreach trigger server + queue worker.
#
# This package runs TypeScript directly via tsx (no build step) and — after
# dropping its unused twenty-shared/twenty-client-sdk workspace deps — depends
# only on public npm packages, so it installs standalone without the monorepo.
#
# Railway builds this with the build context set to the package directory
# (RAILWAY_DOCKERFILE_PATH points here). Default command runs both the HTTP
# trigger server and the queue worker in one process (`serve`).
FROM node:24-slim

WORKDIR /app

# Install deps first for layer caching. Only package.json changes bust this.
# --legacy-peer-deps: @ai-sdk/* declare a zod@^3 peer but the package runs on
# zod@^4 (verified working in the yarn monorepo); npm's strict peer check would
# otherwise abort. tsx/typescript are the runtime + dev tooling tsx needs.
COPY package.json ./
RUN npm install --omit=dev --no-package-lock --legacy-peer-deps \
  && npm install --no-package-lock --legacy-peer-deps tsx@^4.19.0 typescript@^5.6.0

# App source (src/, prompts/, tsconfig.json, etc.). .dockerignore keeps
# node_modules, .env, and runtime-artifact dirs out of the image.
COPY . .

ENV NODE_ENV=production

# Railway injects PORT; the trigger server reads it. Documented for clarity.
EXPOSE 8787

# Run trigger server + worker together. Override to `npx tsx src/queue/worker.ts`
# or `.../server/trigger-server.ts` to split into two services.
CMD ["npx", "tsx", "src/server/serve-all.ts"]
