const db = {
  select() {
    return this;
  },
  from(table: unknown) {
    return [table];
  },
};
const pets = { id: 'pets' };

export default function health() {
  return db.select().from(pets);
}
