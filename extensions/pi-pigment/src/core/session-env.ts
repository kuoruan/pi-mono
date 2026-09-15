/**
 * A session's file environment: the working directory and agent directory
 * every file layer (config, themes) resolves against. Pre-session callers
 * (the theme command before `session_start`) synthesize it from the
 * process environment.
 */
export interface SessionEnv {
  /** Project working directory (project config, project themes). */
  cwd: string;
  /** Agent directory (global config, user themes, converted-theme output). */
  agentDir: string;
}
