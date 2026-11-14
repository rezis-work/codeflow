import { CACHE, type CachePort, type PetReader, PetsService } from './pets';

function Controller(..._args: unknown[]): ClassDecorator {
  return () => undefined;
}
function Get(..._args: unknown[]): MethodDecorator {
  return () => undefined;
}
function Post(..._args: unknown[]): MethodDecorator {
  return () => undefined;
}
function Put(..._args: unknown[]): MethodDecorator {
  return () => undefined;
}
function Patch(..._args: unknown[]): MethodDecorator {
  return () => undefined;
}
function Delete(..._args: unknown[]): MethodDecorator {
  return () => undefined;
}
function All(..._args: unknown[]): MethodDecorator {
  return () => undefined;
}
function Inject(..._args: unknown[]): ParameterDecorator {
  return () => undefined;
}

const dynamic = '/computed';

@Controller('pets')
export class PetsController {
  constructor(
    private readonly pets: PetsService,
    private readonly reader: PetReader,
    @Inject(CACHE) private readonly cache: CachePort,
  ) {}

  @Get()
  list() {
    this.reader.findOne('1');
    this.cache.get('pets');
    return this.pets.findAll();
  }

  @Get(':id')
  one() {
    return this.reader.findOne('1');
  }

  @Post()
  create() {
    return this.pets.findAll();
  }

  @Put(':id')
  replace() {
    return null;
  }

  @Patch(':id')
  patch() {
    return null;
  }

  @Delete(':id')
  remove() {
    return null;
  }

  @All('raw')
  raw() {
    return null;
  }

  @Get(dynamic)
  computed() {
    return null;
  }
}
