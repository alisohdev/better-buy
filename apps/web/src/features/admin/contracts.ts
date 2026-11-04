function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown) {
  if (!isRecord(value)) throw new Error("Invalid admin record");
  return value;
}
function text(value: unknown) {
  if (typeof value !== "string") throw new Error("Invalid admin text");
  return value;
}
function count(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid admin count");
  return value;
}
function number(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Invalid admin number");
  return value;
}
function boolean(value: unknown) {
  if (typeof value !== "boolean") throw new Error("Invalid admin boolean");
  return value;
}
function nullableText(value: unknown) {
  return value === null ? null : text(value);
}
function list<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Invalid admin list");
  return value.map(parse);
}
function source(value: unknown) {
  switch (value) {
    case "snappmarket":
    case "okala":
    case "digikalajet":
    case "all":
      return value;
    default:
      throw new Error("Invalid analytics source");
  }
}

export function parseAdminAccess(value: unknown) {
  return { allowed: boolean(record(value).allowed) };
}

export function parseAdminOverview(value: unknown) {
  const data = record(value);
  const totals = record(data.totals);
  return {
    generatedAt: text(data.generatedAt),
    trackingSince: nullableText(data.trackingSince),
    totals: {
      users: count(totals.users),
      visits: count(totals.visits),
      visitors: count(totals.visitors),
      searches: count(totals.searches),
      scans: count(totals.scans),
      locations: count(totals.locations),
      wishlistItems: count(totals.wishlistItems),
      cartItems: count(totals.cartItems),
    },
    days: list(data.days, (value) => {
      const day = record(value);
      return {
        date: text(day.date),
        visits: count(day.visits),
        visitors: count(day.visitors),
        searches: count(day.searches),
      };
    }),
    topSearches: list(data.topSearches, (value) => {
      const search = record(value);
      return {
        query: text(search.query),
        searches: count(search.searches),
        users: count(search.users),
      };
    }),
  };
}

function parseUser(value: unknown) {
  const user = record(value);
  return {
    id: text(user.id),
    name: text(user.name),
    email: text(user.email),
    emailVerified: boolean(user.emailVerified),
    createdAt: text(user.createdAt),
    lastSeenAt: nullableText(user.lastSeenAt),
    visits: count(user.visits),
    searches: count(user.searches),
    scans: count(user.scans),
    locations: count(user.locations),
    wishlistItems: count(user.wishlistItems),
    cartItems: count(user.cartItems),
  };
}

export function parseAdminUsers(value: unknown) {
  const data = record(value);
  return {
    users: list(data.users, parseUser),
    page: count(data.page),
    pageSize: count(data.pageSize),
    total: count(data.total),
  };
}

export function parseAdminUser(value: unknown) {
  const data = record(value);
  return {
    user: parseUser(data.user),
    locations: list(data.locations, (value) => {
      const item = record(value);
      return {
        id: text(item.id),
        name: text(item.name),
        latitude: number(item.latitude),
        longitude: number(item.longitude),
        isDefault: boolean(item.isDefault),
      };
    }),
    wishlist: list(data.wishlist, (value) => {
      const item = record(value);
      return {
        id: text(item.id),
        phrase: text(item.phrase),
        minDiscount: count(item.minDiscount),
        createdAt: text(item.createdAt),
      };
    }),
    cart: list(data.cart, (value) => {
      const item = record(value);
      return {
        source: source(item.source),
        key: text(item.key),
        title: text(item.title),
        quantity: count(item.quantity),
        updatedAt: text(item.updatedAt),
      };
    }),
    recentSearches: list(data.recentSearches, (value) => {
      const item = record(value);
      return {
        query: text(item.query),
        source: source(item.source),
        createdAt: text(item.createdAt),
      };
    }),
  };
}
