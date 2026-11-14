import { loadPets } from '../../../lib/pets';

export function GET() {
  return loadPets();
}
