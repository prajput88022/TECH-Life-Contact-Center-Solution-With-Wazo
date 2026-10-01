// =====================================================================
// TECH-Life Contact-Center Solution
// Role Policy
// =====================================================================
// Central policy map for role-specific route access and permissions.
// =====================================================================

const ROLE_POLICY = {
  superadmin: {
    route: '/superadmin',
    permissions: ['tenant.create', 'tenant.edit', 'tenant.delete', 'tenant.switch', 'users.create', 'users.edit', 'users.delete', 'roles.assign', 'roles.view', 'queues.create', 'queues.edit', 'queues.delete', 'campaigns.create', 'campaigns.edit', 'campaigns.delete', 'ivr.create', 'ivr.edit', 'ivr.delete', 'reports.view', 'reports.export', 'themes.manage'],
    description: 'Platform-level tenant lifecycle authority'
  },
  admin: {
    route: '/admin',
    permissions: ['tenant.edit', 'tenant.switch', 'users.create', 'users.edit', 'users.view', 'roles.assign', 'roles.view', 'queues.create', 'queues.edit', 'queues.delete', 'campaigns.create', 'campaigns.edit', 'campaigns.delete', 'ivr.create', 'ivr.edit', 'ivr.delete', 'reports.view', 'reports.export', 'themes.manage'],
    description: 'Tenant admin with full tenant-scoped control'
  },
  manager: {
    route: '/admin',
    permissions: ['queues.create', 'queues.edit', 'queues.delete', 'queues.view', 'campaigns.create', 'campaigns.edit', 'campaigns.delete', 'campaigns.view', 'campaigns.robo', 'ivr.create', 'ivr.edit', 'ivr.delete', 'ivr.view', 'ivr.audio', 'reports.view', 'reports.export', 'agent.view', 'recordings.view', 'themes.manage'],
    description: 'Queue, campaign, IVR, recording and reports manager'
  },
  user_manager: {
    route: '/admin/users',
    permissions: ['users.create', 'users.edit', 'users.view', 'roles.view', 'roles.assign'],
    description: 'User management only; no tenant or user delete rights'
  },
  reports_only: {
    route: '/mis',
    permissions: ['reports.view', 'reports.export', 'recordings.view', 'agent.view'],
    description: 'Read-only reports access'
  },
  supervisor: {
    route: '/supervisor',
    permissions: ['queues.view', 'campaigns.view', 'ivr.view', 'reports.view', 'agent.view'],
    description: 'Supervisor operations'
  },
  agent: {
    route: '/agent',
    permissions: ['agent.view', 'queues.view'],
    description: 'Agent workspace access'
  }
};

function getRolePolicy(roleName) {
  return ROLE_POLICY[(roleName || '').toLowerCase()] || ROLE_POLICY.agent;
}

function getRouteForRole(roleName) {
  return getRolePolicy(roleName).route;
}

module.exports = {
  ROLE_POLICY,
  getRolePolicy,
  getRouteForRole
};
