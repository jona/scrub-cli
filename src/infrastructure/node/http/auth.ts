import { createHash, timingSafeEqual } from "node:crypto";

/** Transport authentication is composed server-side; no provider token enters application input. */
export function createBearerAuthorizer(token: string | undefined) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = token?.trim() ? digest(token) : undefined;
  return (request: Request): boolean => {
    const header = request.headers.get("authorization") ?? "";
    return (
      expected !== undefined &&
      header.startsWith("Bearer ") &&
      timingSafeEqual(expected, digest(header.slice(7)))
    );
  };
}
