#ifndef ATHENA_OPAQUE_CORE_H
#define ATHENA_OPAQUE_CORE_H

#ifdef __cplusplus
extern "C" {
#endif

char *athena_opaque_start_registration(const char *password);
char *athena_opaque_finish_registration(const char *json);
char *athena_opaque_start_login(const char *password);
char *athena_opaque_finish_login(const char *json);
void athena_opaque_string_free(char *value);

#ifdef __cplusplus
}
#endif

#endif
