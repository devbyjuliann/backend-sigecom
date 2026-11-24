#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "mariadbd" || "${1:-}" == "mysqld" ]]; then
  data_directory="/var/lib/mysql"
  certificate_directory="${data_directory}/sigecom-tls"
  private_domain="${RAILWAY_PRIVATE_DOMAIN:?RAILWAY_PRIVATE_DOMAIN is required}"

  if [[ ! "$private_domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
    echo "RAILWAY_PRIVATE_DOMAIN is not a valid DNS name." >&2
    exit 1
  fi

  install -d -o mysql -g mysql -m 0750 "$certificate_directory"

  ca_file="${certificate_directory}/ca.pem"
  server_certificate="${certificate_directory}/server-cert.pem"
  server_key="${certificate_directory}/server-key.pem"

  if [[ ! -s "$ca_file" || ! -s "$server_certificate" || ! -s "$server_key" ]]; then
    temporary_directory="$(mktemp -d)"
    trap 'rm -rf "$temporary_directory"' EXIT
    umask 077

    openssl genrsa -out "${temporary_directory}/ca-key.pem" 4096
    openssl req \
      -x509 \
      -new \
      -key "${temporary_directory}/ca-key.pem" \
      -sha256 \
      -days 3650 \
      -subj "/CN=SIGECOM MariaDB CA" \
      -out "${temporary_directory}/ca.pem"

    openssl genrsa -out "${temporary_directory}/server-key.pem" 2048
    openssl req \
      -new \
      -key "${temporary_directory}/server-key.pem" \
      -subj "/CN=${private_domain}" \
      -out "${temporary_directory}/server.csr"

    cat >"${temporary_directory}/server.ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:${private_domain}
EOF

    openssl x509 \
      -req \
      -in "${temporary_directory}/server.csr" \
      -CA "${temporary_directory}/ca.pem" \
      -CAkey "${temporary_directory}/ca-key.pem" \
      -CAcreateserial \
      -out "${temporary_directory}/server-cert.pem" \
      -days 3650 \
      -sha256 \
      -extfile "${temporary_directory}/server.ext"

    install -o mysql -g mysql -m 0644 "${temporary_directory}/ca.pem" "$ca_file"
    install -o mysql -g mysql -m 0644 "${temporary_directory}/server-cert.pem" "$server_certificate"
    install -o mysql -g mysql -m 0640 "${temporary_directory}/server-key.pem" "$server_key"
  fi

  openssl verify -CAfile "$ca_file" -purpose sslserver "$server_certificate" >/dev/null
  openssl x509 -in "$server_certificate" -noout -checkhost "$private_domain" >/dev/null

  set -- "$@" \
    "--ssl-ca=${ca_file}" \
    "--ssl-cert=${server_certificate}" \
    "--ssl-key=${server_key}" \
    "--require-secure-transport=ON"
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
