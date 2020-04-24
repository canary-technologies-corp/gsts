
/**
 * Module dependencies.
 */

const { dirname } = require('path');
const Parser = require('./parser');
const IAM = require('aws-sdk/clients/iam');
const STS = require('aws-sdk/clients/sts');
const errors = require('./errors');
const fs = require('fs').promises;
const ini = require('ini');

// Delta (in seconds) between exact expiration date and current date to avoid requests
// on the same second to fail.
const SESSION_EXPIRATION_DELTA = 30e3; // 30 seconds

/**
 * Process a SAML response and extract all relevant data to be exchanged for an
 * STS token.
 */

class CredentialsManager {
  constructor(logger) {
    this.logger = logger;
    this.sessionExpirationDelta = SESSION_EXPIRATION_DELTA;
    this.parser = new Parser(logger);
  }

  async prepareRoleWithSAML(response, customRoleArn) {
    const { roles, samlAssertion } = await this.parser.parseSamlResponse(response, customRoleArn);

    if (!customRoleArn) {
      this.logger.debug('A custom role ARN not been set so returning all parsed roles');

      return {
        roles,
        samlAssertion
      }
    }

    const customRole = roles.find(role => role.roleArn === customRoleArn);

    if (!customRole) {
      throw new errors.RoleNotFoundError(roles);
    }

    this.logger.debug('Found custom role ARN "%s" with principal ARN "%s"', customRole.roleArn, customRole.principalArn);

    return {
      roles: [customRole],
      samlAssertion
    }
  }

  /**
   * Parse SAML response and assume role-.
   */

  async assumeRoleWithSAML(samlAssertion, awsSharedCredentialsFile, awsProfile, role, customSessionDuration) {
    let sessionDuration = role.sessionDuration;

    if (customSessionDuration) {
      sessionDuration = customSessionDuration;

      const iamResponse = await (new IAM()).getRole({
        RoleName: role.name
      }).promise();

      if (customSessionDuration > iamResponse.Role.MaxSessionDuration) {
        sessionDuration = iamResponse.Role.MaxSessionDuration;

        this.logger.warn('Custom session duration %d exceeds maximum session duration of %d allowed for role. Please set --aws-session-duration=%d or $AWS_SESSION_DURATION=%d to surpress this warning', customSessionDuration, iamResponse.Role.MaxSessionDuration, iamResponse.Role.MaxSessionDuration, iamResponse.Role.MaxSessionDuration);
      }
    }

    const stsResponse = await (new STS()).assumeRoleWithSAML({
      DurationSeconds: sessionDuration,
      PrincipalArn: role.principalArn,
      RoleArn: role.roleArn,
      SAMLAssertion: samlAssertion
    }).promise();

    this.logger.debug('Role ARN "%s" has been assumed %O', role.roleArn, stsResponse);

    await this.saveCredentials(awsSharedCredentialsFile, awsProfile, {
      accessKeyId: stsResponse.Credentials.AccessKeyId,
      secretAccessKey: stsResponse.Credentials.SecretAccessKey,
      sessionExpiration: stsResponse.Credentials.Expiration,
      sessionToken: stsResponse.Credentials.SessionToken
    });
  }

  /**
   * Load AWS credentials from the user home preferences.
   * Optionally accepts a AWS profile (usually a name representing
   * a section on the .ini-like file).
   */

  async loadCredentials(path, profile) {
    let credentials;

    try {
      credentials = await fs.readFile(path, 'utf-8')
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.logger.debug('Credentials file does not exist at %s', path)
        return;
      }

      throw e;
    }

    const config = ini.parse(credentials);

    if (profile) {
      return config[profile];
    }

    return config;
  }

  /**
   * Save AWS credentials to a profile section.
   */

  async saveCredentials(path, profile, { accessKeyId, secretAccessKey, sessionExpiration, sessionToken }) {
    // The config file may have other profiles configured, so parse existing data instead of writing a new file instead.
    let credentials = await this.loadCredentials(path);

    if (!credentials) {
      credentials = {};
    }

    credentials[profile] = {};
    credentials[profile].aws_access_key_id = accessKeyId;
    credentials[profile].aws_secret_access_key = secretAccessKey;
    credentials[profile].aws_session_expiration = sessionExpiration.toISOString();
    credentials[profile].aws_session_token = sessionToken;

    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, ini.encode(credentials))

    this.logger.debug('The credentials have been stored in "%s" under AWS profile "%s" with contents %o', path, profile, credentials);
  }

  /**
   * Extract session expiration from AWS credentials file for a given profile.
   * The property `sessionExpirationDelta` represents a safety buffer to avoid requests
   * failing at the exact time of expiration.
   */

  async getSessionExpirationFromCredentials(path, profile) {
    this.logger.debug('Attempting to retrieve session expiration credentials');

    const credentials = await this.loadCredentials(path, profile);

    if (!credentials) {
      return { isValid: false, expiresAt: null };
    }

    if (!credentials.aws_session_expiration) {
      this.logger.debug('Session expiration date not found');

      return { isValid: false, expiresAt: null };
    }

    if (new Date(credentials.aws_session_expiration).getTime() - this.sessionExpirationDelta > Date.now()) {
      this.logger.debug('Session is expected to be valid until %s minus expiration delta of %d seconds', credentials.aws_session_expiration, this.sessionExpirationDelta / 1e3);

      return { isValid: true, expiresAt: new Date(credentials.aws_session_expiration).getTime() - this.sessionExpirationDelta };
    }

    this.logger.debug('Session has expired on %s', credentials.aws_session_expiration);

    return { isValid: false, expiresAt: new Date(credentials.aws_session_expiration).getTime() - this.sessionExpirationDelta };
  }
}

/**
 * Exports.
 */

module.exports = CredentialsManager;