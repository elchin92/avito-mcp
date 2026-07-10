import { describe, expect, it } from 'vitest';

import { domainOfToolName, toolName, toSnakeCase } from '../src/meta/tool-naming.js';

describe('tool naming metadata', () => {
  it('prefers the longest domain prefix', () => {
    expect(domainOfToolName('cpa_get_chats')).toBe('cpa');
    expect(domainOfToolName('cpa_auction_get_bids')).toBe('cpa_auction');
    expect(domainOfToolName('cpa_target_post_action')).toBe('cpa_target');
  });

  it('classifies meta and unknown tools explicitly', () => {
    expect(domainOfToolName('meta_health')).toBe('meta');
    expect(domainOfToolName('unexpected_tool')).toBe('unknown');
  });

  it('builds stable snake-case names', () => {
    expect(toSnakeCase('getUserBalance')).toBe('get_user_balance');
    expect(toolName('items', 'getItemInfo')).toBe('items_get_item_info');
  });
});
