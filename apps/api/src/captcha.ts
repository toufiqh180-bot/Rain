import { env } from "./env.js";
import { ApiError } from "./http.js";

/**
 * Verifies an hCaptcha token. Called from signup and guest endpoints.
 * Returns true if the token is valid and score is acceptable.
 */
export async function verifyCaptcha(token: string, remoteIp: string): Promise<boolean> {
  if (!env.HCAPTCHA_SECRET) {
    // Captcha not configured; skip verification in development.
    if (env.NODE_ENV !== "production") return true;
    throw ApiError.unavailable("Captcha verification unavailable.");
  }

  try {
    const response = await fetch("https://hcaptcha.com/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: env.HCAPTCHA_SECRET,
        response: token,
        remoteip: remoteIp,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`hCaptcha returned ${response.status}`);
    }

    const result = (await response.json()) as {
      success: boolean;
      challenge_ts?: string;
      hostname?: string;
      score?: number;
      error_codes?: string[];
    };

    if (!result.success) {
      return false;
    }

    // hCaptcha's score: 0.0 to 1.0. Only allow if >= 0.5 (neutral/good)
    if (result.score !== undefined && result.score < 0.5) {
      return false;
    }

    return true;
  } catch (error) {
    console.error(JSON.stringify({
      event: "captcha_verification_error",
      error: error instanceof Error ? error.message : String(error),
    }));
    // On network failure, fail open in development, fail closed in production
    return env.NODE_ENV !== "production";
  }
}

/**
 * Generates a simple device fingerprint from user-agent and a browser-provided hash.
 * Called from the frontend and verified on the backend to detect suspicious patterns.
 */
export function generateDeviceFingerprint(userAgent: string, fingerprint: string): string {
  // This is a simple concatenation; in production, hash it or use a more robust method
  return Buffer.from(`${userAgent}:${fingerprint}`).toString("base64");
}

/**
 * Checks if a device (IP + fingerprint combo) is currently blocked or high-risk.
 * Returns risk score: 0 = safe, 1 = suspicious, 2 = blocked.
 */
export async function assessDeviceRisk(
  ip: string,
  fingerprint: string,
  query: (sql: string, params: unknown[]) => Promise<{ count: string }[]>,
): Promise<number> {
  // Check if device is explicitly blocked
  const blocked = await query(
    `select count(*)::text as count from device_fingerprints 
     where lower(fingerprint) = $1 and is_blocked = true limit 1`,
    [fingerprint],
  );

  if (Number(blocked[0]?.count ?? 0) > 0) {
    return 2; // Blocked
  }

  // Check if IP has multiple blocked accounts
  const multipleBlocked = await query(
    `select count(*)::text as count from device_fingerprints 
     where ip = $1 and is_blocked = true`,
    [ip],
  );

  if (Number(multipleBlocked[0]?.count ?? 0) > 2) {
    return 2; // Blocked
  }

  // Check if device has recent abuse
  const recentAbuse = await query(
    `select count(*)::text as count from reports 
     where reporter_account_id in (
       select account_id from device_fingerprints where lower(fingerprint) = $1
     ) and created_at > now() - interval '24 hours'
     and reason in ('harassment', 'sexual-content', 'hate', 'minor-safety')`,
    [fingerprint],
  );

  if (Number(recentAbuse[0]?.count ?? 0) > 3) {
    return 1; // Suspicious
  }

  return 0; // Safe
}
