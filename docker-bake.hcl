variable "TAG" {
  default = "dev"
}

variable "PLATFORM" {
  default = "linux/amd64"
}

group "default" {
  targets = ["local-cli"]
}

target "_native" {
  context = "."
  dockerfile = "Dockerfile"
  target = "runner"
  platforms = [PLATFORM]
}

target "local-cli" {
  inherits = ["_native"]
  tags = ["scrub:local-cli-${TAG}"]
  args = {
    SCRUB_ENTRYPOINT = "dist/deployments/local/cli.js"
  }
}

target "local-api" {
  inherits = ["_native"]
  tags = ["scrub:local-api-${TAG}"]
  args = {
    SCRUB_ENTRYPOINT = "dist/deployments/local/api.js"
  }
}

target "server-api" {
  inherits = ["local-api"]
  tags = ["scrub:server-api-${TAG}"]
}

target "local-mcp" {
  inherits = ["_native"]
  tags = ["scrub:local-mcp-${TAG}"]
  args = {
    SCRUB_ENTRYPOINT = "dist/deployments/local/mcp.js"
  }
}

# The Rivet host serves both HTTP job routes and Streamable HTTP MCP.
target "rivet-api" {
  inherits = ["_native"]
  tags = ["scrub:rivet-api-${TAG}"]
  platforms = ["linux/amd64"]
  args = {
    SCRUB_ENTRYPOINT = "dist/deployments/rivet/main.js"
    SCRUB_DEPENDENCY_HOOK = "rivet/prune-dependencies.sh"
  }
}
