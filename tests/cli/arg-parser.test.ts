import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../src/cli.js';

describe('parseArgs', () => {
  describe('command detection', () => {
    it('no args defaults to help', () => {
      const result = parseArgs([]);
      expect(result.command).toBe('help');
    });

    it('dashboard command', () => {
      const result = parseArgs(['dashboard']);
      expect(result.command).toBe('dashboard');
    });

    it('recover command', () => {
      const result = parseArgs(['recover']);
      expect(result.command).toBe('recover');
    });

    it('unknown command falls back to help', () => {
      const result = parseArgs(['unknown']);
      expect(result.command).toBe('help');
    });
  });

  describe('flag parsing', () => {
    it('--port sets port', () => {
      const result = parseArgs(['dashboard', '--port', '8080']);
      expect(result.port).toBe(8080);
    });

    it('--db sets db path', () => {
      const result = parseArgs(['dashboard', '--db', '/tmp/test.db']);
      expect(result.db).toBe('/tmp/test.db');
    });

    it('--postgres sets postgres connection string', () => {
      const result = parseArgs(['recover', '--postgres', 'postgresql://localhost']);
      expect(result.postgres).toBe('postgresql://localhost');
    });

    it('--timeout sets timeout', () => {
      const result = parseArgs(['recover', '--timeout', '60000']);
      expect(result.timeout).toBe(60000);
    });
  });

  describe('default values when flags omitted', () => {
    it('port defaults to 3100', () => {
      const result = parseArgs(['dashboard']);
      expect(result.port).toBe(3100);
    });

    it('db defaults to ./durable-agents.db', () => {
      const result = parseArgs(['dashboard']);
      expect(result.db).toBe('./durable-agents.db');
    });

    it('timeout defaults to 30000', () => {
      const result = parseArgs(['recover']);
      expect(result.timeout).toBe(30000);
    });

    it('postgres is undefined by default', () => {
      const result = parseArgs(['recover']);
      expect(result.postgres).toBeUndefined();
    });
  });

  describe('invalid values', () => {
    it('non-numeric port results in NaN', () => {
      const result = parseArgs(['dashboard', '--port', 'abc']);
      expect(result.port).toBeNaN();
    });
  });

  describe('flag ordering', () => {
    it('flags before subcommand are still parsed', () => {
      const result = parseArgs(['--port', '9000', 'dashboard']);
      expect(result.command).toBe('dashboard');
      expect(result.port).toBe(9000);
    });

    it('mixed flag order works', () => {
      const result = parseArgs(['recover', '--timeout', '5000', '--db', '/data/my.db']);
      expect(result.command).toBe('recover');
      expect(result.timeout).toBe(5000);
      expect(result.db).toBe('/data/my.db');
    });
  });
});
