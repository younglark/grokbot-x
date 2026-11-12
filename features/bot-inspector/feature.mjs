// features/bot-inspector: read-only "Bot 透视" side panel injected into Grok Bot.
// Data is read from the in-memory roster found on the React fiber tree. No RPC,
// no writes, no isAnysphereUser changes. The page script does all the work.
export default {
  name: 'bot-inspector',
  messageTypes: [],
  pageScript: 'inject.js',
};
