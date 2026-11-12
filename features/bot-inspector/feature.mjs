// features/bot-inspector: read-only "Bot 透视" cross-bot status strip injected into Grok Bot.
// Data is read from the in-memory roster found on the React fiber tree. No RPC,
// no writes, no isAnysphereUser changes. The page script does all the work.
export default {
  name: 'bot-inspector',
  messageTypes: [],
  pageScript: 'inject.js',
};
