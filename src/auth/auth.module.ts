import { Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import {
  loadOperatorAuthConfig,
  OPERATOR_AUTH_CONFIG,
  type OperatorAuthConfig,
} from './operator-auth.config';
import { OperatorAuthGuard } from './operator-auth.guard';

@Module({
  providers: [
    // Validated once at startup; malformed keys abort bootstrap.
    { provide: OPERATOR_AUTH_CONFIG, useFactory: () => loadOperatorAuthConfig() },
    OperatorAuthGuard,
  ],
  exports: [OPERATOR_AUTH_CONFIG, OperatorAuthGuard],
})
export class AuthModule implements OnApplicationBootstrap {
  constructor(
    @Inject(OPERATOR_AUTH_CONFIG) private readonly config: OperatorAuthConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.credentials.length === 0) {
      new Logger(AuthModule.name).warn(
        'OPERATOR_API_KEYS is empty: the delivery operations endpoints reject every request.',
      );
    }
  }
}
