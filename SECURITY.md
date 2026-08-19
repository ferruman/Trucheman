# Security Policy

## Supported versions

Trucheman is currently pre-1.0. Security fixes are applied to the latest commit on `main`; older
commits and local modifications are not supported.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability
reporting for this repository:

<https://github.com/ferruman/Trucheman/security/advisories/new>

Include affected versions, reproduction steps, impact, and any suggested mitigation. Remove API
keys, copyrighted book text, and personal data from the report. You should receive an initial
response within seven days. Please allow time for a fix before public disclosure.

## Security model

Trucheman binds to loopback by default and is intended as a single-user local application. It is
not designed to be exposed directly to the public internet. External-provider mode sends eligible
book text to the configured provider; users are responsible for the provider's terms and the rights
to process that content.
