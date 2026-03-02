export {};

declare global {
  namespace Express {
    interface AuthUser {
      id: string;
      orgId: string;
      email: string;
      name: string;
      role: string;
    }

    interface Request {
      orgId?: string;
      user?: AuthUser;
    }
  }
}
