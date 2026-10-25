import nodemailer from "nodemailer";
import { env } from "../config/env";

/**
 * Brevo SMTP Transporter
 * Using smtp-relay.brevo.com:587 (STARTTLS)
 */
export const mailTransporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_PORT === 465, // false for port 587
  auth: {
    user: env.SMTP_USER,
    pass: env.SMTP_PASS,
  },
  tls: {
    rejectUnauthorized: env.NODE_ENV === "production",
  },
});

/**
 * Builds the exact Anonmee landing-page themed HTML template.
 * Matches:
 * - Wordmark logo with tilted peach sticker ("anon" + "mee")
 * - Cobalt brand background (#3b4bff)
 * - Playful sticker outline & hard drop-shadows (2px solid #14111c, 4px/6px solid shadow)
 * - Peach action badges (#ffa07e) and coral-rose stamps (#ff6b8b)
 * - 6-digit OTP code styled with high contrast monospace digits
 * - Feature pills: "Dating & Flirting", "Make Real Friends", "Stranger Chat", "No Photo Pressure"
 */
export function buildVerificationEmailHtml(code: string, username?: string): string {
  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${code} is your Anonmee verification code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #14111c; -webkit-font-smoothing: antialiased;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f4f4f8; padding: 36px 16px;">
    <tr>
      <td align="center">
        <!-- Main Card Container: Cobalt brand with thick edge and sticker drop-shadow -->
        <table role="presentation" width="100%" style="max-width: 500px; background-color: #3b4bff; border: 2.5px solid #14111c; border-radius: 24px; box-shadow: 6px 6px 0 0 #14111c; overflow: hidden; border-collapse: separate;">
          
          <!-- Brand Header -->
          <tr>
            <td style="padding: 28px 24px 20px 24px; text-align: center;">
              <!-- Exact Anonmee Wordmark Logo -->
              <div style="display: inline-block;">
                <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 34px; font-weight: 900; letter-spacing: -1.5px; color: #f6f7ff; vertical-align: middle;">anon</span><span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 32px; font-weight: 900; background-color: #ffa07e; border: 2.5px solid #14111c; color: #14111c; border-radius: 8px; margin-left: 3px; padding: 1px 7px 3px 7px; display: inline-block; transform: rotate(-3deg); -webkit-transform: rotate(-3deg); box-shadow: 2px 2px 0 0 #14111c; vertical-align: middle;">mee</span>
              </div>
              
              <!-- Tagline Pill -->
              <div style="margin-top: 10px;">
                <span style="display: inline-block; background-color: rgba(20, 17, 28, 0.25); border: 1.5px solid rgba(246, 247, 255, 0.4); border-radius: 9999px; padding: 4px 14px; font-size: 11px; font-weight: 800; color: #f6f7ff; letter-spacing: 0.8px; text-transform: uppercase;">
                  Anonymous Dating &bull; Friendship &bull; 18+ Only
                </span>
              </div>
            </td>
          </tr>

          <!-- Inner Content Card (Sticker sheet style) -->
          <tr>
            <td style="padding: 0 16px 16px 16px;">
              <table role="presentation" width="100%" style="background-color: #fbfbfd; border: 2.5px solid #14111c; border-radius: 18px; box-shadow: 4px 4px 0 0 #14111c; border-collapse: separate;">
                <tr>
                  <td style="padding: 28px 24px;">
                    
                    <!-- Poster Headline -->
                    <h1 style="margin: 0 0 12px 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 24px; font-weight: 900; color: #14111c; letter-spacing: -0.5px; line-height: 1.15; text-align: center;">
                      Verify your email.<br/>
                      Stay <span style="background-color: #ffa07e; border: 2px solid #14111c; border-radius: 8px; padding: 2px 8px; display: inline-block; transform: rotate(-1deg); -webkit-transform: rotate(-1deg); box-shadow: 2px 2px 0 0 #14111c;">anonymous.</span>
                    </h1>

                    <p style="margin: 0 0 20px 0; font-size: 15px; line-height: 1.5; color: #595666; text-align: center;">
                      ${username ? `Hey <strong>${username}</strong>, ` : "Hey there, "}enter this 6-digit code in the signup wizard to verify your email. <strong>No account is created until this code is entered.</strong>
                    </p>

                    <!-- The 6-Digit OTP Sticker Box -->
                    <div style="background-color: #ffa07e; border: 2.5px solid #14111c; border-radius: 16px; box-shadow: 4px 4px 0 0 #14111c; padding: 20px 12px; text-align: center; margin: 24px 0;">
                      <p style="margin: 0 0 4px 0; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.5px; color: #14111c;">
                        Verification Code
                      </p>
                      <span style="font-family: 'SF Mono', Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #14111c; display: block; padding-left: 10px;">
                        ${code}
                      </span>
                    </div>

                    <!-- App Pillars: Match Landing Page Sticker Badges -->
                    <div style="text-align: center; margin: 22px 0 16px 0;">
                      <span style="display: inline-block; background-color: #ffa07e; color: #14111c; border: 1.5px solid #14111c; border-radius: 9999px; font-size: 11px; font-weight: 800; padding: 3px 10px; margin: 3px; box-shadow: 1.5px 1.5px 0 0 #14111c;">
                        Dating &amp; Flirting
                      </span>
                      <span style="display: inline-block; background-color: #ff6b8b; color: #14111c; border: 1.5px solid #14111c; border-radius: 9999px; font-size: 11px; font-weight: 800; padding: 3px 10px; margin: 3px; box-shadow: 1.5px 1.5px 0 0 #14111c;">
                        Make Real Friends
                      </span>
                      <span style="display: inline-block; background-color: #fbfbfd; color: #14111c; border: 1.5px solid #14111c; border-radius: 9999px; font-size: 11px; font-weight: 800; padding: 3px 10px; margin: 3px; box-shadow: 1.5px 1.5px 0 0 #14111c;">
                        Stranger Chat
                      </span>
                      <span style="display: inline-block; background-color: #ffa07e; color: #14111c; border: 1.5px solid #14111c; border-radius: 9999px; font-size: 11px; font-weight: 800; padding: 3px 10px; margin: 3px; box-shadow: 1.5px 1.5px 0 0 #14111c;">
                        No Photo Pressure
                      </span>
                    </div>

                    <!-- Microcopy & Expiry -->
                    <div style="border-top: 2px dashed rgba(20, 17, 28, 0.15); margin-top: 20px; padding-top: 16px; text-align: center;">
                      <p style="margin: 0; font-size: 13px; font-weight: 600; color: #595666;">
                        &#9201; Valid for <strong>15 minutes</strong>. If you did not request this code, simply disregard this email.
                      </p>
                    </div>

                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Dark Footer Strip -->
          <tr>
            <td style="background-color: #14111c; padding: 18px 24px; text-align: center;">
              <p style="margin: 0 0 6px 0; font-size: 12px; font-weight: 600; color: #f4f3fa;">
                Nobody ever sees your email or username. Only your gender and age.
              </p>
              <p style="margin: 0; font-size: 11px; color: #a9a5b8;">
                &copy; ${year} Anonmee &bull; 100% Free Anonymous Social App &bull; Adults 18+
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/**
 * Sends a branded 6-digit email verification code via Brevo SMTP.
 */
export async function sendVerificationEmail(
  to: string,
  code: string,
  username?: string
): Promise<{ success: boolean; error?: string }> {
  // Always log verification code to server console so developers can easily test
  console.log(`\n======================================================`);
  console.log(`[Anonmee Email Verification]`);
  console.log(`To: ${to}`);
  console.log(`Code: ${code}`);
  console.log(`Expires in: 15 minutes`);
  console.log(`======================================================\n`);

  if (env.NODE_ENV === "test") {
    return { success: true };
  }

  const subject = `${code} is your Anonmee verification code`;
  const text = `Welcome to Anonmee!\n\nYour 6-digit verification code is: ${code}\n\nThis code will expire in 15 minutes. Enter this code on the signup screen to verify your email and activate your account.\n\nWithout verification, no account is created.\n\n--\nAnonmee Team\nhttps://anonmee.orincore.com`;

  const html = buildVerificationEmailHtml(code, username);

  try {
    await mailTransporter.sendMail({
      from: env.SMTP_FROM,
      to,
      subject,
      text,
      html,
    });
    return { success: true };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[Brevo SMTP Notice] Could not deliver email directly via Brevo: ${errorMsg}`);
    if (errorMsg.includes("525") || errorMsg.includes("Unauthorized IP")) {
      console.warn(
        `[Brevo Warning] Brevo returned 525 Unauthorized IP address. To enable direct delivery, add your IP in Brevo Dashboard > SMTP & API > Authorized IPs. The code was logged above for verification.`
      );
    }
    return { success: false, error: errorMsg };
  }
}
