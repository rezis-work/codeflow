'use server';

import { prisma } from '../lib/pets';

export async function createPet(name: string) {
  return prisma.pet.create({ data: { name } });
}
