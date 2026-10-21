import { randomInt } from "node:crypto";

const ADJ = ["Quiet", "Brave", "Gentle", "Sunny", "Midnight", "Cosmic", "Velvet", "Mellow", "Wild", "Calm", "Golden", "Hidden", "Lucky", "Misty", "Silver", "Swift", "Cozy", "Bright", "Dusty", "Electric"];
const NOUN = ["Otter", "Fox", "Panda", "Falcon", "Koala", "Lynx", "Heron", "Comet", "Willow", "Ember", "Marlin", "Sparrow", "Badger", "Orchid", "Lantern", "Maple", "Pebble", "Raven", "Tulip", "Wolf"];

/** Random display name such as "Quiet Otter 47". Not derived from any account data. */
export function randomAlias(): string {
  return `${ADJ[randomInt(ADJ.length)]} ${NOUN[randomInt(NOUN.length)]} ${randomInt(10, 100)}`;
}
