export class PetsRepository {
  findAll() {
    return this.prisma.pet.findMany();
  }

  private prisma = {
    pet: {
      findMany: () => [],
    },
  };
}

export class PetsService {
  constructor(private readonly repo: PetsRepository) {}

  findAll() {
    return this.repo.findAll();
  }
}

export interface PetReader {
  findOne(id: string): Promise<unknown>;
}

export class PrismaPetReader implements PetReader {
  findOne(id: string) {
    return this.prisma.pet.findUnique({ where: { id } });
  }

  private prisma = {
    pet: {
      findUnique: (_query: unknown) => Promise.resolve(null),
    },
  };
}

export const CACHE = 'CACHE_TOKEN';

export interface CachePort {
  get(key: string): string | undefined;
}

export class MemoryCache implements CachePort {
  get(_key: string) {
    return undefined;
  }
}

export const cacheProvider = { provide: CACHE, useClass: MemoryCache };
