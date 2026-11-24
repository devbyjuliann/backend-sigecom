FROM mariadb:11.8.9

COPY entrypoint.sh /usr/local/bin/sigecom-mariadb-entrypoint
RUN chmod 0755 /usr/local/bin/sigecom-mariadb-entrypoint

ENTRYPOINT ["/usr/local/bin/sigecom-mariadb-entrypoint"]
CMD ["mariadbd"]
