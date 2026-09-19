# Privacy Policy

**Last Updated:** September 18, 2026

## 1. Introduction

Rain ("**Service**," "**we**," "**us**," "**our**") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our website and services.

**PLEASE READ THIS PRIVACY POLICY CAREFULLY.** If you do not agree with our policies and practices, please do not use our Service.

---

## 2. Information We Collect

### 2.1 Account Information
When you sign up (as a regular user or guest), we collect:
- Email address (for regular accounts only; guests do not need email)
- Password hash (never the plaintext password)
- Username / display name
- Gender identity and seeking preferences (private; not shared)
- Profile bio and avatar image (optional)
- Date and time of account creation
- Age gate acceptance (timestamp and policy version)

### 2.2 Guest Accounts (Special Privacy)
Guest accounts are **temporary and ephemeral:**
- No email is required
- No password is stored
- Account is **permanently deleted when you log out**
- No data is retained after deletion
- You cannot recover a guest account

### 2.3 Communication Data
When you use Rain, we collect:
- **Text messages** in matches: stored only during the match; deleted when either person leaves
- **Voice/video call metadata**: connection duration, participants, timestamp; audio/video is NOT recorded by us
- Connection requests and friend list (only if you accept mutual friendships)

**We do NOT store message transcripts by default.** This is a privacy-first design choice.

### 2.4 Device & Network Information
For safety and fraud prevention, we automatically collect:
- IP address
- User-Agent string (browser/device type)
- Device fingerprint (combination of IP + browser characteristics)
- Operating system and browser version
- Approximate location (inferred from IP, not precise)

### 2.5 Usage Analytics
We collect non-identifying analytics:
- Pages visited
- Time spent in each section
- Features used (e.g., text matching, voice invite)
- Error logs (to improve the service)
- Queue wait times

**We do NOT sell or share this data with third parties.**

### 2.6 Cookies & Tracking

We use cookies for:
- **Session management** (HttpOnly, Secure, SameSite=Lax): stores your login session
- **CSRF protection** (visible to JavaScript but double-verified): prevents cross-site forgery
- **Device preferences** (optional sound setting): stored in browser local storage, not on servers

We do **not** use third-party tracking cookies or analytics pixels.

---

## 3. How We Use Your Information

We use collected information for:

1. **Providing the Service**
   - Matching you with other users
   - Storing your profile and connections
   - Processing friend requests
   - Delivering messages and notifications

2. **Safety & Abuse Prevention**
   - Detecting and blocking spam/bot accounts
   - Tracking patterns of harassment or sexual content
   - Enforcing age restrictions (18+ only)
   - Investigating and responding to abuse reports

3. **Moderation & Enforcement**
   - Reviewing reported content
   - Taking action against violating accounts (warn, mute, suspend, ban)
   - Maintaining audit logs of moderation decisions

4. **Legal Compliance**
   - Complying with law enforcement requests
   - Defending against legal claims
   - Meeting GDPR/CCPA obligations

5. **Service Improvement**
   - Analyzing usage patterns
   - Fixing bugs and crashes
   - Improving performance and stability
   - Adding new features based on user feedback

**We will NEVER:**
- Sell your data to advertisers
- Use your profile for marketing
- Share your messages or identity with third parties
- Track you across other websites
- Use your data for AI training without explicit consent

---

## 4. Data Retention

### 4.1 Regular Accounts
| Data | Retention Period | Reason |
|------|------------------|--------|
| Account profile | Until you delete it | You need to access it |
| Sessions | 30 days (auto-revoke) | Security best practice |
| Connection requests | Until accepted/declined | Functional requirement |
| DMs with friends | Until you delete it | You need to reference them |
| Login attempts | 7 days | Brute-force protection |
| Device fingerprints | 30 days | Abuse pattern detection |
| Reports you filed | 90 days (then anonymized) | Investigation window |
| Audit logs | 90 days (then redacted) | Compliance window |

### 4.2 Guest Accounts
**All data is permanently deleted on logout.** No backup, no recovery.

### 4.3 Anonymization
After 90 days, old data is anonymized:
- Audit logs have personal details removed
- Reports lose reporter identity
- Device fingerprints are cleared
- IP addresses are generalized

---

## 5. Data Sharing & Third Parties

### 5.1 We Share Data With:
- **Stripe** (if you purchase a paid plan): email, payment info
- **Resend** (email provider): email address for verification/password reset
- **hCaptcha** (abuse prevention): IP address only, for CAPTCHA verification
- **LiveKit** (voice/video SFU): your profile name and session ID for call routing
- **Amazon S3** (if enabled): your avatar image
- **Redis** (message queue): ephemeral message copies while in transit

### 5.2 We Do NOT Share With:
- Advertisers
- Data brokers
- Other analytics companies
- Social media platforms
- Governmental agencies (except under valid legal process)

### 5.3 Law Enforcement
We comply with valid court orders and legal subpoenas. We will:
1. Require a court order or subpoena
2. Notify you of the request (unless legally prohibited)
3. Provide only the minimum data requested
4. Not voluntarily disclose information

---

## 6. International Data Transfers

If you are in the **European Union**, your data is protected under GDPR:
- We process data based on legitimate interest (safety) and contractual necessity (service)
- You have the right to access, correct, delete, or port your data
- You can file a complaint with your local data protection authority

If you are in **California**, your data is protected under CCPA:
- You have the right to know what data we collect
- You have the right to delete your data
- You have the right to opt-out (though we don't sell data)

---

## 7. Children's Privacy

**Rain is restricted to users 18 and older.** We do NOT knowingly collect data from minors.

If we learn that a minor has provided personal information:
1. We immediately delete their account
2. We delete all associated data
3. We report the incident to applicable authorities

**Parents/guardians:** If you believe a minor has used Rain, contact us immediately at [CONTACT_EMAIL].

---

## 8. Data Security

We protect your data with:
- **TLS 1.3 encryption** for all data in transit
- **Database encryption at rest** (AES-256)
- **Hashed passwords** (scrypt with 131,072 rounds)
- **Token hashing** (session and CSRF tokens hashed before storage)
- **Rate limiting** to prevent brute-force attacks
- **Access controls** (principle of least privilege)
- **Regular security audits** and penetration testing

**No security is perfect.** If we experience a data breach:
1. We will investigate within 24 hours
2. We will notify affected users within 72 hours
3. We will provide steps to secure your account
4. We will cooperate with law enforcement if needed

---

## 9. Your Rights

### 9.1 Access Your Data
Email us to request a copy of all data we hold about you. We will provide it in a standard, portable format within 30 days.

### 9.2 Correct Your Data
You can update your profile, bio, and preferences anytime in the app.

### 9.3 Delete Your Data
You can delete your account anytime in settings. This:
- Deletes your profile
- Deletes your connections and DM history
- Removes you from all circles
- Revokes all active sessions
- Clears device fingerprints

**Guest accounts automatically delete on logout** (no action needed).

### 9.4 Data Portability
You can request a ZIP file of all your data in a portable format (JSON).

### 9.5 Withdraw Consent
You can revoke consent to collect device/analytics data in your privacy settings.

---

## 10. Cookies & Local Storage

### Cookies We Set:
| Name | Purpose | Duration | Type |
|------|---------|----------|------|
| `rain_sid` | Session token | 30 days | HttpOnly, Secure |
| `rain_csrf` | CSRF token | 30 days | Readable by JS |

### Browser Storage:
- **localStorage**: Sound preference (on/off) — stored on your device only, never sent to servers

You can clear these anytime by clearing your browser data.

---

## 11. Third-Party Links

Rain may contain links to external websites. **We are not responsible for their privacy practices.** Please review their privacy policies before sharing information with them.

---

## 12. Contact Us

For privacy questions or to exercise your rights:

**Email:** [YOUR_PRIVACY_EMAIL@rain.yoursite.com]
**Mailing Address:** [YOUR_ADDRESS]
**Data Protection Officer:** [YOUR_DPO_NAME] ([DPO_EMAIL])

We will respond to all requests within 30 days.

---

## 13. Policy Updates

We may update this Privacy Policy as the service changes. Changes become effective 30 days after posting. **Continued use of Rain constitutes acceptance of the updated policy.**

We will notify you of material changes via:
- Email to your registered address
- A prominent notice on our website
- An in-app notification

---

## 14. Jurisdiction & Governing Law

This Privacy Policy is governed by the laws of **[YOUR_JURISDICTION]** and the **General Data Protection Regulation (GDPR)** and **California Consumer Privacy Act (CCPA)**, whichever provides greater protection.

---

**By using Rain, you consent to the collection and use of information as described in this Privacy Policy.**

If you do not agree, please do not use the service.

---

*Last updated: September 18, 2026*
*Version: 1.0*
