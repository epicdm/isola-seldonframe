export function logAuthRequestPath(method: "GET" | "POST", request: { nextUrl: { pathname: string } }): void {
  console.log(`[auth][route] ${method}`, request.nextUrl.pathname);
}
