export const prisma = {
  pet: {
    findMany: () => [],
    create: (_input: unknown) => ({ id: '1' }),
  },
};

export function loadPets() {
  return prisma.pet.findMany();
}
