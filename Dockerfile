ARG NODE_IMAGE=node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf
FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG SCRUB_DEPENDENCY_HOOK
COPY package.json package-lock.json ./
RUN --mount=type=bind,source=deployments,target=/tmp/scrub-deployment,readonly \
    npm ci --no-audit --no-fund \
    && if [ -n "$SCRUB_DEPENDENCY_HOOK" ]; then sh "/tmp/scrub-deployment/$SCRUB_DEPENDENCY_HOOK"; fi
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ARG DEBIAN_SNAPSHOT=20261026T000000Z
# The pinned Node CA roots bootstrap verified HTTPS before ca-certificates exists.
RUN node -e "require('fs').writeFileSync('/tmp/node-roots.pem', require('tls').rootCertificates.join('\\n'))" \
    && printf '%s\n' \
       "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ trixie main" \
       "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ trixie-updates main" \
       "deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ trixie-security main" \
       > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::https::CaInfo=/tmp/node-roots.pem update \
    && apt-get -o Acquire::https::CaInfo=/tmp/node-roots.pem upgrade -y \
    && apt-get -o Acquire::https::CaInfo=/tmp/node-roots.pem install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/* /tmp/node-roots.pem
COPY deployments/image/requirements.txt /tmp/scrub-requirements.txt
ARG WHISPER_BASE_REVISION=ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir --require-hashes --only-binary=:all: -r /tmp/scrub-requirements.txt \
    && /opt/venv/bin/python -m pip check \
    && /opt/venv/bin/python -c "from pathlib import Path; from faster_whisper.utils import download_model; model = Path(download_model('base', cache_dir='/opt/scrub-models', revision='${WHISPER_BASE_REVISION}')); refs = model.parent.parent / 'refs'; refs.mkdir(exist_ok=True); (refs / 'main').write_text(model.name)" \
    && /opt/venv/bin/python -m pip uninstall --yes pip \
    && printf '%s\n' '--js-runtimes node' > /etc/yt-dlp.conf \
    && rm /tmp/scrub-requirements.txt
COPY package.json package-lock.json ./
ARG SCRUB_DEPENDENCY_HOOK
RUN --mount=type=bind,source=deployments,target=/tmp/scrub-deployment,readonly \
    npm ci --omit=dev --no-audit --no-fund \
    && if [ -n "$SCRUB_DEPENDENCY_HOOK" ]; then sh "/tmp/scrub-deployment/$SCRUB_DEPENDENCY_HOOK"; fi \
    && npm cache clean --force \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build /app/dist ./dist
COPY LICENSE ./
COPY deployments/image/licenses ./third_party_licenses
LABEL io.scrub.debian-snapshot="${DEBIAN_SNAPSHOT}" \
      io.scrub.whisper-base-revision="${WHISPER_BASE_REVISION}"
ARG SCRUB_REQUEST_CONCURRENCY=1
ARG SCRUB_RUNNER_CONCURRENCY=2
ARG SCRUB_GLOBAL_CONCURRENCY=none
ARG SCRUB_SUMMARY_PROVIDER=openai
ARG SCRUB_SUMMARY_MODEL=gpt-6.1-sol
ARG SCRUB_VISION_PROVIDER=openai
ARG SCRUB_VISION_MODEL=gpt-6.1-terra
ARG SCRUB_OPENAI_MODELS=gpt-6.1-sol,gpt-6.1-terra,gpt-6-luna
ARG SCRUB_ANTHROPIC_MODELS=claude-sonnet-5-5
ARG SCRUB_INFERENCE_LIMITS={}
ARG SCRUB_MODEL_TIMEOUT_MS=600000
ENV SCRUB_REQUEST_CONCURRENCY=${SCRUB_REQUEST_CONCURRENCY}
ENV SCRUB_RUNNER_CONCURRENCY=${SCRUB_RUNNER_CONCURRENCY}
ENV SCRUB_GLOBAL_CONCURRENCY=${SCRUB_GLOBAL_CONCURRENCY}
ENV SCRUB_SUMMARY_PROVIDER=${SCRUB_SUMMARY_PROVIDER}
ENV SCRUB_SUMMARY_MODEL=${SCRUB_SUMMARY_MODEL}
ENV SCRUB_VISION_PROVIDER=${SCRUB_VISION_PROVIDER}
ENV SCRUB_VISION_MODEL=${SCRUB_VISION_MODEL}
ENV SCRUB_OPENAI_MODELS=${SCRUB_OPENAI_MODELS}
ENV SCRUB_ANTHROPIC_MODELS=${SCRUB_ANTHROPIC_MODELS}
ENV SCRUB_INFERENCE_LIMITS=${SCRUB_INFERENCE_LIMITS}
ENV SCRUB_MODEL_TIMEOUT_MS=${SCRUB_MODEL_TIMEOUT_MS}
ENV NODE_ENV=production
ENV PATH="/opt/venv/bin:${PATH}"
ENV HF_HUB_CACHE=/opt/scrub-models
ENV HF_HUB_OFFLINE=1
ARG SCRUB_ENTRYPOINT=dist/deployments/local/cli.js
ENV SCRUB_ENTRYPOINT=${SCRUB_ENTRYPOINT}
# Deployment composition chooses the module; exec preserves signals and CLI arguments.
ENTRYPOINT ["sh", "-c", "exec node \"$SCRUB_ENTRYPOINT\" \"$@\"", "scrub"]
CMD []
