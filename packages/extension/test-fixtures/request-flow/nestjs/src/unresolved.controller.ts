import { Controller, Get } from '@nestjs/common';

@Controller('extra')
export class ExtraController {
  @Get('ping')
  ping() {
    return 'ok';
  }
}
