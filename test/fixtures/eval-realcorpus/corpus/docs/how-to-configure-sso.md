# How to configure SSO (SAML) for the workspace

This guide walks an admin through enabling SAML single sign-on so employees log in
with the corporate identity provider instead of a local password.

1. In Settings → Security → SSO, choose "SAML 2.0" and copy the Assertion Consumer
   Service (ACS) URL and the Service Provider entity ID.
2. In your identity provider (Okta, Azure AD, or Google Workspace), create a new
   SAML application and paste the ACS URL and entity ID.
3. Download the IdP metadata XML and upload it back into the SSO settings, or paste
   the IdP SSO URL and the signing certificate fingerprint by hand.
4. Map the `email`, `firstName`, and `lastName` SAML attributes to the user profile
   fields. Set the NameID format to EmailAddress.
5. Run a test login from the IdP. Once it succeeds, flip "Require SSO for all members"
   so password login is disabled for the org.

Troubleshooting: a clock skew between the IdP and the service is the usual cause of
"invalid SAML response" errors — verify both sides are within 30 seconds of NTP.
