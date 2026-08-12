export interface Organization {
  id: string;
  name: string;
  slug: string;
  role: string;
  modules: unknown;
}

export interface MeResponse {
  authenticated: boolean;
  mfaSatisfied?: boolean;
  user?: {
    id: string;
    email: string;
    name: string;
    isStaff: boolean;
  };
  currentOrgId?: string | null;
  role?: string | null;
  organizations?: Organization[];
}

export interface LoginResponse {
  mfaRequired: boolean;
  orgId: string | null;
  needsOrgChoice: boolean;
}
