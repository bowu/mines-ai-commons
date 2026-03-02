import "express-session";

declare module "express-session" {
  interface SessionData {
    userId: string;
    orgId: string;
    email: string;
    name: string;
    role: string;
    oidcState?: string;
    oidcNonce?: string;
    oidcCodeVerifier?: string;
  }
}
