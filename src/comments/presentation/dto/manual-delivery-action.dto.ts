import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ManualDeliveryActionDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 1000,
    example: 'Provider incident resolved; operator approved another attempt.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string;
}
