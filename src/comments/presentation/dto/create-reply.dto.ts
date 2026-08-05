import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateReplyDto {
  @ApiProperty({
    example: 'Thank you for your feedback!',
    minLength: 1,
    maxLength: 5000,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  message!: string;
}
